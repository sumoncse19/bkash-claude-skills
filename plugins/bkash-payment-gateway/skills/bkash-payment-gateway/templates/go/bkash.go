// Package bkash is a bKash PGW v2 Tokenized Checkout client (Go 1.21+, stdlib only).
// Docs: https://developer.bka.sh
package bkash

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	SandboxURL    = "https://tokenized.sandbox.bka.sh/v2/tokenized-checkout"
	ProductionURL = "https://tokenized.pay.bka.sh/v2/tokenized-checkout"
	refreshBefore = 8 * time.Minute
)

var (
	safeText   = regexp.MustCompile(`^[^<>&]*$`)
	amountRe   = regexp.MustCompile(`^\d+(\.\d{1,2})?$`)
	ErrTimeout = errors.New("bkash: request timed out — status unknown, use Query APIs")
	doneCodes  = map[string]bool{"2062": true, "2068": true, "2117": true, "2119": true}
)

// Error is a bKash business/API error.
type Error struct {
	Code         string // externalCode or statusCode
	InternalCode string
	Message      string // errorMessageEn — safe to show to customers
	HTTPStatus   int
	Raw          map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("bkash %s: %s", e.Code, e.Message) }

// TokenState is what the TokenStore persists.
type TokenState struct {
	IDToken          string      `json:"id_token"`
	RefreshToken     string      `json:"refresh_token"`
	ExpiresAt        time.Time   `json:"expires_at"`
	RefreshExpiresAt time.Time   `json:"refresh_expires_at"`
	AuthCalls        []time.Time `json:"auth_calls"`
}

// TokenStore must be shared across processes in production (Redis, DB row lock...).
type TokenStore interface {
	Get(ctx context.Context) (*TokenState, error)
	Set(ctx context.Context, s *TokenState) error
	WithLock(ctx context.Context, fn func() error) error
}

// MemoryStore is a single-process TokenStore.
type MemoryStore struct {
	mu    sync.Mutex
	state *TokenState
}

func (m *MemoryStore) Get(context.Context) (*TokenState, error)   { return m.state, nil }
func (m *MemoryStore) Set(_ context.Context, s *TokenState) error { m.state = s; return nil }
func (m *MemoryStore) WithLock(_ context.Context, fn func() error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return fn()
}

type Config struct {
	BaseURL, Username, Password, AppKey, AppSecret string
	BearerPrefix                                   bool
	Store                                          TokenStore
	HTTPClient                                     *http.Client
}

type Client struct {
	cfg   Config
	store TokenStore
	hc    *http.Client
}

func New(cfg Config) *Client {
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Store == nil {
		cfg.Store = &MemoryStore{}
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{cfg: cfg, store: cfg.Store, hc: hc}
}

func FromEnv(store TokenStore) *Client {
	base := os.Getenv("BKASH_BASE_URL")
	if base == "" {
		base = SandboxURL
	}
	return New(Config{BaseURL: base, Username: os.Getenv("BKASH_USERNAME"), Password: os.Getenv("BKASH_PASSWORD"),
		AppKey: os.Getenv("BKASH_APP_KEY"), AppSecret: os.Getenv("BKASH_APP_SECRET"),
		BearerPrefix: os.Getenv("BKASH_BEARER_PREFIX") == "true", Store: store})
}

// ---------------------------------------------------------------- tokens

func (c *Client) Token(ctx context.Context) (string, error) {
	if s, _ := c.store.Get(ctx); s != nil && time.Now().Before(s.ExpiresAt.Add(-refreshBefore)) {
		return s.IDToken, nil
	}
	var tok string
	err := c.store.WithLock(ctx, func() error {
		s, err := c.store.Get(ctx)
		if err != nil {
			return err
		}
		now := time.Now()
		if s != nil && now.Before(s.ExpiresAt.Add(-refreshBefore)) {
			tok = s.IDToken
			return nil
		}
		var recent []time.Time
		if s != nil {
			for _, t := range s.AuthCalls {
				if now.Sub(t) < time.Hour {
					recent = append(recent, t)
				}
			}
		}
		if len(recent) >= 2 {
			if s != nil && now.Before(s.ExpiresAt) {
				tok = s.IDToken
				return nil
			}
			return errors.New("bkash: refusing grant/refresh, 2 calls already in the last hour")
		}
		var res map[string]any
		if s != nil && now.Before(s.RefreshExpiresAt) {
			res, err = c.auth(ctx, "/auth/refresh-token", map[string]any{"app_key": c.cfg.AppKey, "app_secret": c.cfg.AppSecret, "refresh_token": s.RefreshToken})
			recent = append(recent, now)
			if err != nil {
				if len(recent) >= 2 {
					return err
				}
				res = nil
			}
		}
		if res == nil {
			res, err = c.auth(ctx, "/auth/grant-token", map[string]any{"app_key": c.cfg.AppKey, "app_secret": c.cfg.AppSecret})
			if err != nil {
				return err
			}
			recent = append(recent, time.Now())
		}
		exp := 3600.0
		switch v := res["expires_in"].(type) {
		case float64:
			exp = v
		case string:
			fmt.Sscanf(v, "%f", &exp)
		}
		ns := &TokenState{IDToken: str(res["id_token"]), RefreshToken: str(res["refresh_token"]),
			ExpiresAt: time.Now().Add(time.Duration(exp) * time.Second), RefreshExpiresAt: time.Now().Add(29 * 24 * time.Hour), AuthCalls: recent}
		tok = ns.IDToken
		return c.store.Set(ctx, ns)
	})
	return tok, err
}

func (c *Client) auth(ctx context.Context, path string, body map[string]any) (map[string]any, error) {
	r, err := c.post(ctx, path, body, map[string]string{"username": c.cfg.Username, "password": c.cfg.Password})
	if err != nil {
		return nil, err
	}
	if str(r["statusCode"]) != "0000" || str(r["id_token"]) == "" {
		return nil, &Error{Code: str(r["statusCode"]), Message: str(r["statusMessage"]), HTTPStatus: 200, Raw: r}
	}
	return r, nil
}

// ---------------------------------------------------------------- transport

func (c *Client) post(ctx context.Context, path string, body map[string]any, headers map[string]string) (map[string]any, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+path, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() || errors.Is(err, context.DeadlineExceeded) {
			return nil, ErrTimeout
		}
		return nil, &Error{Message: "network error: " + err.Error(), HTTPStatus: 0}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, &Error{Message: fmt.Sprintf("non-JSON response (%d)", resp.StatusCode), HTTPStatus: resp.StatusCode}
		}
	}
	if out == nil {
		out = map[string]any{}
	}
	if resp.StatusCode >= 400 && out["externalCode"] == nil && out["statusCode"] == nil {
		return nil, &Error{Code: fmt.Sprint(resp.StatusCode), Message: fmt.Sprintf("HTTP %d", resp.StatusCode), HTTPStatus: resp.StatusCode, Raw: out}
	}
	return out, nil
}

func (c *Client) call(ctx context.Context, path string, body map[string]any) (map[string]any, error) {
	tok, err := c.Token(ctx)
	if err != nil {
		return nil, err
	}
	if c.cfg.BearerPrefix {
		tok = "Bearer " + tok
	}
	out, err := c.post(ctx, path, body, map[string]string{"Authorization": tok, "X-App-Key": c.cfg.AppKey})
	if err != nil {
		return nil, err
	}
	if ec := str(out["externalCode"]); ec != "" || (str(out["statusCode"]) != "" && str(out["statusCode"]) != "0000") {
		code := ec
		if code == "" {
			code = str(out["statusCode"])
		}
		msg := str(out["errorMessageEn"])
		if msg == "" {
			msg = str(out["statusMessage"])
		}
		return nil, &Error{Code: code, InternalCode: str(out["internalCode"]), Message: msg, HTTPStatus: 200, Raw: out}
	}
	if out["bkashURL"] == nil && out["bKashURL"] != nil {
		out["bkashURL"] = out["bKashURL"]
	}
	return out, nil
}

func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

// ---------------------------------------------------------------- validation

func Amount(s string) (string, error) {
	s = strings.TrimSpace(s)
	if !amountRe.MatchString(s) || strings.Trim(s, "0.") == "" {
		return "", fmt.Errorf("bkash: invalid amount %q", s)
	}
	return s, nil
}

func Safe(s string, max int) (string, error) {
	if !safeText.MatchString(s) || len([]rune(s)) > max {
		return "", fmt.Errorf("bkash: invalid text (no < > &, max %d)", max)
	}
	return s, nil
}

// ---------------------------------------------------------------- API

type PaymentRequest struct {
	Amount, MerchantInvoiceNumber, CallbackURL string
	PayerReference                             string // required without agreement
	AgreementID                                string // set to use payment-with-agreement
	Intent                                     string // "sale" (default) or "authorization"
	SubMerchantName, MerchantAssociationInfo   string
}

func (c *Client) CreatePayment(ctx context.Context, p PaymentRequest) (map[string]any, error) {
	amt, err := Amount(p.Amount)
	if err != nil {
		return nil, err
	}
	inv, err := Safe(p.MerchantInvoiceNumber, 255)
	if err != nil {
		return nil, err
	}
	intent := p.Intent
	if intent == "" {
		intent = "sale"
	}
	body := map[string]any{"callbackURL": p.CallbackURL, "amount": amt, "currency": "BDT", "intent": intent, "merchantInvoiceNumber": inv}
	if p.SubMerchantName != "" {
		if body["subMerchantName"], err = Safe(p.SubMerchantName, 80); err != nil {
			return nil, err
		}
	}
	if p.MerchantAssociationInfo != "" {
		if body["merchantAssociationInfo"], err = Safe(p.MerchantAssociationInfo, 255); err != nil {
			return nil, err
		}
	}
	if p.AgreementID != "" {
		body["agreementId"] = p.AgreementID
		return c.call(ctx, "/payment-with-agreement/create", body)
	}
	if body["payerReference"], err = Safe(p.PayerReference, 255); err != nil {
		return nil, err
	}
	return c.call(ctx, "/payment/create", body)
}

func (c *Client) withAgreement(path, paymentID, agreementID string) (string, map[string]any) {
	if agreementID != "" {
		return "/payment-with-agreement/" + path, map[string]any{"paymentId": paymentID, "agreementId": agreementID}
	}
	return "/payment/" + path, map[string]any{"paymentId": paymentID}
}

func (c *Client) ExecutePayment(ctx context.Context, paymentID, agreementID string) (map[string]any, error) {
	p, b := c.withAgreement("execute", paymentID, agreementID)
	return c.call(ctx, p, b)
}
func (c *Client) CapturePayment(ctx context.Context, paymentID, agreementID string) (map[string]any, error) {
	p, b := c.withAgreement("capture", paymentID, agreementID)
	return c.call(ctx, p, b)
}
func (c *Client) VoidPayment(ctx context.Context, paymentID, agreementID string) (map[string]any, error) {
	p, b := c.withAgreement("void", paymentID, agreementID)
	return c.call(ctx, p, b)
}

func (c *Client) CreateAgreement(ctx context.Context, payerReference, callbackURL string) (map[string]any, error) {
	ref, err := Safe(payerReference, 255)
	if err != nil {
		return nil, err
	}
	return c.call(ctx, "/agreement/create", map[string]any{"payerReference": ref, "callbackURL": callbackURL})
}
func (c *Client) ExecuteAgreement(ctx context.Context, id string) (map[string]any, error) {
	return c.call(ctx, "/agreement/execute", map[string]any{"agreementId": id})
}
func (c *Client) CancelAgreement(ctx context.Context, id string) (map[string]any, error) {
	return c.call(ctx, "/agreement/cancel", map[string]any{"agreementId": id})
}
func (c *Client) QueryAgreement(ctx context.Context, id string) (map[string]any, error) {
	return c.call(ctx, "/query/agreement", map[string]any{"agreementId": id})
}
func (c *Client) QueryPayment(ctx context.Context, paymentID string) (map[string]any, error) {
	return c.call(ctx, "/query/payment", map[string]any{"paymentId": paymentID})
}
func (c *Client) SearchTransaction(ctx context.Context, trxID string) (map[string]any, error) {
	return c.call(ctx, "/general/search-transaction", map[string]any{"trxId": trxID})
}
func (c *Client) Refund(ctx context.Context, paymentID, trxID, amount, sku, reason string) (map[string]any, error) {
	amt, err := Amount(amount)
	if err != nil {
		return nil, err
	}
	if _, err = Safe(sku, 255); err != nil {
		return nil, err
	}
	if _, err = Safe(reason, 255); err != nil {
		return nil, err
	}
	return c.call(ctx, "/refund/payment/transaction", map[string]any{"paymentId": paymentID, "trxId": trxID, "refundAmount": amt, "sku": sku, "reason": reason})
}
func (c *Client) RefundStatus(ctx context.Context, paymentID, trxID string) (map[string]any, error) {
	return c.call(ctx, "/refund/payment/status", map[string]any{"paymentId": paymentID, "trxId": trxID})
}

// ExecuteWithRecovery executes once and falls back to Query Payment when the outcome is unknown.
func (c *Client) ExecuteWithRecovery(ctx context.Context, paymentID, agreementID string) (string, map[string]any, error) {
	d, err := c.ExecutePayment(ctx, paymentID, agreementID)
	if err == nil {
		return str(d["transactionStatus"]), d, nil
	}
	var be *Error
	unknown := errors.Is(err, ErrTimeout) || (errors.As(err, &be) && (be.HTTPStatus == 0 || be.HTTPStatus >= 500 || doneCodes[be.Code]))
	if !unknown {
		return "", nil, err
	}
	q, qerr := c.QueryPayment(ctx, paymentID)
	if qerr != nil {
		return "", nil, qerr
	}
	return str(q["transactionStatus"]), q, nil
}
