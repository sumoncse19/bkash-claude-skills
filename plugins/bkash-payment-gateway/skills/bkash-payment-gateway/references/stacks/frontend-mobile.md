# Frontend (React/Vue/Angular/Svelte) and mobile (Flutter, React Native, Android, iOS)

**Golden rule:** the browser or app never talks to bKash's API and never holds credentials. It asks *your* backend to create a payment, opens the returned `bkashURL`, and learns the result from *your* backend.

## Web SPA

```ts
async function payWithBkash(orderId: string) {
  const r = await fetch("/api/payments/bkash", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Could not start bKash payment");
  window.location.assign(data.redirectUrl);   // full-page redirect, not an iframe/popup
}
```

- Use a full-page redirect. Popups get blocked on mobile browsers; iframes are the legacy Checkout iFrame product.
- The callback lands on your **backend** route, which executes the payment and then redirects to a frontend result page such as `/orders/:id?payment=success|failed|cancelled|processing`.
- The result page should fetch order status from your API (don't trust the query string) and poll briefly while it shows `processing`.
- Disable the Pay button after the first click to avoid creating two payments.
- Show the bKash brand button per bKash's brand guidelines (get assets from bKash; don't recreate the logo).

Vue/Angular/Svelte: same call in a service; `window.location.href = redirectUrl`.

## Mobile apps (Flutter, React Native, native Android/iOS)

Flow: app → your backend `POST /payments/bkash` → receive `redirectUrl` → open in a WebView (or Custom Tab / SFSafariViewController) → intercept navigation to your `callbackURL` → let your backend execute → show result.

Option A — WebView with interception (most common):
- Load `redirectUrl` in a WebView with JavaScript enabled.
- In the navigation delegate, when the URL starts with your callback base (`https://api.example.com/payments/bkash/callback`), let the request go through to your backend (it performs Execute) **or** cancel the navigation and call your backend's `/payments/bkash/complete?paymentID=...&status=...&signature=...` with the app's auth token. Do not call bKash Execute from the app.
- Close the WebView and show the result from your backend's response.

Flutter (`webview_flutter`):
```dart
final controller = WebViewController()
  ..setJavaScriptMode(JavaScriptMode.unrestricted)
  ..setNavigationDelegate(NavigationDelegate(
    onNavigationRequest: (req) {
      if (req.url.startsWith(callbackBase)) {
        final uri = Uri.parse(req.url);
        Navigator.of(context).pop(uri.queryParameters);   // {paymentID, status, signature}
        return NavigationDecision.prevent;
      }
      return NavigationDecision.navigate;
    },
  ))
  ..loadRequest(Uri.parse(redirectUrl));
// After pop: POST the params to your backend's /payments/bkash/complete; it validates + executes.
```

React Native (`react-native-webview`):
```tsx
<WebView
  source={{ uri: redirectUrl }}
  onShouldStartLoadWithRequest={(req) => {
    if (req.url.startsWith(CALLBACK_BASE)) {
      const q = Object.fromEntries(new URL(req.url).searchParams);
      onFinish(q);           // send to backend /payments/bkash/complete
      return false;
    }
    return true;
  }}
/>
```

Android (`WebViewClient.shouldOverrideUrlLoading`) and iOS (`WKNavigationDelegate.webView(_:decidePolicyFor:)`) use the same pattern.

Option B — Custom Tabs / ASWebAuthenticationSession: set `callbackURL` to an HTTPS page on your domain that executes server-side and then redirects to an app link / universal link (`myapp://payment-result?order=...`).

Backend `/payments/bkash/complete` = the same callback logic (validate signature against stored value, claim row, execute-with-recovery) but returns JSON instead of a redirect, and requires the app user's auth.

Also handle: user closes the WebView (treat as cancel; the recovery job will Query later), app killed mid-payment (on next launch, ask backend for order status).
