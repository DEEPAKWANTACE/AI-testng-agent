import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * "Demo Shop": a small local app for exercising the discovery worker. Besides normal pages,
 * forms and a login-protected area, it contains traps the worker must refuse: logout and
 * destructive links, redirects to a local canary port and to the cloud metadata IP, and a
 * page that tries to load internal resources from the browser.
 */

export const DEMO_CREDENTIALS = {
  email: process.env.DEMO_USER_EMAIL ?? "shopper@demo-shop.test",
  password: process.env.DEMO_USER_PASSWORD ?? "demo-shopper-pass-1",
};

export type DemoApp = {
  url: string;
  port: number;
  hits: Map<string, number>;
  /** Simulates a regression: the products page loses its heading and list. */
  setBroken: (broken: boolean) => void;
  close: () => Promise<void>;
};

const SESSION = "demo_session";
const sessions = new Set<string>();

const layout = (title: string, body: string, signedIn: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Demo Shop</title>
<style>body{font:15px system-ui;margin:0;color:#1f2937}header{background:#4338ca;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:center}
header a{color:#fff;text-decoration:none}main{padding:24px;max-width:860px}form{display:grid;gap:8px;max-width:360px;margin:16px 0}
label{display:grid;gap:4px}input,select,textarea{padding:6px;border:1px solid #cbd5e1;border-radius:4px}button{padding:8px 12px;background:#4338ca;color:#fff;border:0;border-radius:4px}
footer{padding:24px;border-top:1px solid #e5e7eb;font-size:13px}footer a{margin-right:12px}</style></head>
<body><header><strong>Demo Shop</strong>
<nav aria-label="Main"><a href="/">Home</a> · <a href="/products">Products</a> · <a href="/cart">Cart</a> · <a href="/account">My account</a> · <a href="/about">About us</a></nav>
<form action="/search" method="get" role="search" style="margin:0 0 0 auto;display:flex;gap:4px"><input name="q" aria-label="Search products" placeholder="Search"><button>Search</button></form>
${signedIn ? '<a href="/logout">Sign out</a>' : '<a href="/login">Sign in</a>'}</header>
<main>${body}</main>
<footer><nav aria-label="Footer"><a href="/about">About</a><a href="/help">Help</a><a href="https://example.org/partner">Partner site</a>
<a href="mailto:support@demo-shop.test">Email us</a><a href="javascript:void(0)">Chat</a><a href="/files/terms.pdf">Terms (PDF)</a></nav></footer></body></html>`;

const products = [
  { id: 1, name: "Trail runner shoes", price: 89 },
  { id: 2, name: "Rain jacket", price: 129 },
  { id: 3, name: "Water bottle", price: 19 },
];

export async function startDemoApp({ port = 0, host = "127.0.0.1", canaryPort }: { port?: number; host?: string; canaryPort: number }): Promise<DemoApp> {
  const hits = new Map<string, number>();
  let broken = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://demo.invalid");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const cookie = /(?:^|;\s*)demo_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = Boolean(cookie && sessions.has(cookie));
    const html = (status: number, title: string, body: string, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(layout(title, body, signedIn));
    };
    const redirect = (location: string, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(302, { location, ...headers });
      res.end();
    };

    switch (true) {
      case url.pathname === "/":
        return html(200, "Home", `<h1>Welcome to Demo Shop</h1><p>Gear for the outdoors.</p>
          <ul><li><a href="/products">Browse products</a></li><li><a href="/redirect/safe">Today's deals</a></li>
          <li><a href="/promo">Spring promo</a></li><li><a href="/slow">Store locator</a></li>
          <li><a href="/redirect/internal">Partner login</a></li><li><a href="/redirect/metadata">Status page</a></li>
          <li><a href="/admin/delete-everything">Reset store data</a></li></ul>`);
      case url.pathname === "/products" && broken:
        return html(500, "Error", "<h2>Something went wrong</h2>");
      case url.pathname === "/products":
        return html(200, "Products", `<h1>Products</h1><ul>${products.map((p) => `<li><a href="/products/${p.id}">${p.name}</a> — $${p.price}</li>`).join("")}</ul>
          <a href="/products/legacy">Old catalogue</a>
          <label>Sort by <select name="sort"><option>Price</option><option>Name</option></select></label>`);
      case /^\/products\/\d+$/.test(url.pathname): {
        const product = products.find((p) => `/products/${p.id}` === url.pathname);
        if (!product) return html(404, "Not found", "<h1>Not found</h1>");
        return html(200, product.name, `<h1>${product.name}</h1><p>$${product.price}</p>
          <form action="/cart" method="post" aria-label="Add to cart"><input type="hidden" name="productId" value="${product.id}">
          <label>Quantity <input type="number" name="quantity" min="1" value="1" required></label><button type="submit">Add to cart</button></form>
          <a href="/products">Back to products</a>`);
      }
      case url.pathname === "/cart":
        return html(200, "Cart", `<h1>Your cart</h1><p>2 items</p>
          <form action="/cart/coupon" method="post" aria-label="Apply coupon"><label>Coupon code <input name="coupon" placeholder="SPRING10"></label><button>Apply</button></form>
          <button type="button" aria-label="Empty cart">Empty cart</button><a href="/checkout">Proceed to checkout</a>`);
      case url.pathname === "/checkout":
        return html(200, "Checkout", `<h1>Checkout</h1>
          <form action="/checkout" method="post" aria-label="Checkout"><label>Email <input type="email" name="email" required autocomplete="email"></label>
          <label>Address <textarea name="address" required></textarea></label><label>Card number <input name="card" inputmode="numeric" autocomplete="cc-number" required></label>
          <button type="submit">Place order</button></form><a href="/checkout/help">Payment help</a>`);
      case url.pathname === "/checkout/help":
        return html(200, "Payment help", "<h1>Payment help</h1><p>We accept major cards.</p>");
      case url.pathname === "/search":
        return html(200, "Search", `<h1>Results for “${(url.searchParams.get("q") ?? "").replace(/[<>&"]/g, "")}”</h1>`);
      case url.pathname === "/about":
        return html(200, "About us", '<h1>About Demo Shop</h1><a href="/about/team">Our team</a>');
      case url.pathname === "/about/team":
        return html(200, "Our team", '<h1>Our team</h1><a href="/about/team/history">Company history</a>');
      case url.pathname === "/about/team/history":
        return html(200, "History", '<h1>History</h1><a href="/about/team/history/archive">Archive</a>');
      case url.pathname === "/about/team/history/archive":
        return html(200, "Archive", "<h1>Archive</h1>");
      case url.pathname === "/help":
        return html(200, "Help", "<h1>Help centre</h1><p>Contact support any time.</p>");
      case url.pathname === "/promo":
        // Tries to reach internal and metadata endpoints from the browser.
        return html(200, "Spring promo", `<h1>Spring promo</h1>
          <img src="http://127.0.0.1:${canaryPort}/pixel.png" alt="" width="1" height="1">
          <img src="http://localhost:${canaryPort}/pixel-by-name.png" alt="" width="1" height="1">
          <iframe src="http://127.0.0.1:${canaryPort}/frame" width="10" height="10"></iframe>
          <img src="https://example.org/banner.png" alt="Banner">
          <script>fetch("http://169.254.169.254/latest/meta-data/").catch(() => {}); fetch("http://127.0.0.1:${canaryPort}/xhr").catch(() => {});</script>`);
      case url.pathname === "/products/legacy":
        // Same host, but outside a /products-scoped authorization.
        return redirect("/cart");
      case url.pathname === "/redirect/safe":
        return redirect("/products?sort=price");
      case url.pathname === "/redirect/internal":
        return redirect(`http://127.0.0.1:${canaryPort}/stolen`);
      case url.pathname === "/redirect/metadata":
        return redirect("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
      case url.pathname === "/slow":
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return html(200, "Store locator", "<h1>Stores</h1>");
      case url.pathname === "/login" && req.method === "POST": {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
        });
        const form = new URLSearchParams(body);
        if (form.get("email") === DEMO_CREDENTIALS.email && form.get("password") === DEMO_CREDENTIALS.password) {
          const token = Math.random().toString(36).slice(2);
          sessions.add(token);
          return redirect("/account", { "set-cookie": `${SESSION}=${token}; HttpOnly; Path=/; SameSite=Lax` });
        }
        return html(401, "Sign in", '<h1>Sign in</h1><p role="alert">Invalid email or password</p>' + loginForm());
      }
      case url.pathname === "/login":
        return html(200, "Sign in", "<h1>Sign in</h1>" + loginForm());
      case url.pathname === "/logout":
        if (cookie) sessions.delete(cookie);
        return redirect("/", { "set-cookie": `${SESSION}=; Max-Age=0; Path=/` });
      case url.pathname.startsWith("/account"):
        if (!signedIn) return redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
        if (url.pathname === "/account/orders") return html(200, "Orders", '<h1>Your orders</h1><table><tr><td>#1001</td><td>Shipped</td></tr></table>');
        return html(200, "My account", `<h1 id="account-heading">My account</h1>
          <form action="/account" method="post" aria-label="Profile"><label>Display name <input name="displayName" value="Sam Shopper"></label>
          <label>Phone <input type="tel" name="phone" value="+1 555 0100"></label><label><input type="checkbox" name="newsletter" checked> Newsletter</label><button>Save profile</button></form>
          <a href="/account/orders">Order history</a>`);
      case url.pathname === "/files/terms.pdf":
        res.writeHead(200, { "content-type": "application/pdf" });
        return res.end("%PDF-1.4");
      default:
        return html(404, "Not found", "<h1>Page not found</h1>");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    hits,
    setBroken: (value) => {
      broken = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function loginForm() {
  return `<form action="/login" method="post" aria-label="Sign in"><label>Email <input type="email" name="email" autocomplete="username" required></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>`;
}

/** A server that should never be reached: any request to it means the egress policy failed. */
export async function startCanary(port = 0): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.end("canary");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
