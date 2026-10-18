package bkash_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sync"
	"testing"

	"example.com/bkash"
)

func TestAgainstMock(t *testing.T) {
	base := os.Getenv("MOCK_URL")
	if base == "" {
		base = "http://127.0.0.1:8765"
	}
	ctx := context.Background()
	c := bkash.New(bkash.Config{BaseURL: base + "/v2/tokenized-checkout", Username: "user", Password: "pass", AppKey: "test_app_key", AppSecret: "secret"})

	r, err := c.CreatePayment(ctx, bkash.PaymentRequest{Amount: "100", MerchantInvoiceNumber: "INV-1", CallbackURL: "https://shop.test/cb", PayerReference: "C"})
	if err != nil {
		t.Fatal(err)
	}
	pid := r["paymentId"].(string)
	if st, _, err := c.ExecuteWithRecovery(ctx, pid, ""); err != nil || st != "Completed" {
		t.Fatalf("execute: %v %v", st, err)
	}
	if st, _, err := c.ExecuteWithRecovery(ctx, pid, ""); err != nil || st != "Completed" {
		t.Fatalf("2062 recovery: %v %v", st, err)
	}
	r2, _ := c.CreatePayment(ctx, bkash.PaymentRequest{Amount: "503.00", MerchantInvoiceNumber: "INV-2", CallbackURL: "https://shop.test/cb", PayerReference: "C"})
	if st, _, err := c.ExecuteWithRecovery(ctx, r2["paymentId"].(string), ""); err != nil || st != "Completed" {
		t.Fatalf("503 recovery: %v %v", st, err)
	}
	_, err = c.CreatePayment(ctx, bkash.PaymentRequest{Amount: "999.99", MerchantInvoiceNumber: "INV-3", CallbackURL: "https://shop.test/cb", PayerReference: "C"})
	var be *bkash.Error
	if !errors.As(err, &be) || be.Code != "2006" || be.Message != "Invalid amount." {
		t.Fatalf("error mapping: %v", err)
	}
	for _, bad := range []string{"0", "-1", "abc", "1.234", "0.00"} {
		if _, err := bkash.Amount(bad); err == nil {
			t.Fatalf("amount %s accepted", bad)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = c.QueryPayment(ctx, pid) }()
	}
	wg.Wait()
	resp, err := http.Get(base + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	var stats map[string]int
	_ = json.NewDecoder(resp.Body).Decode(&stats)
	if stats["grant"] != 1 {
		t.Fatalf("expected 1 grant, got %v", stats)
	}
}
