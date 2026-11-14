import type { Child } from "hono/jsx";

function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>
        <h1>homekeeper</h1>
        {children}
      </body>
    </html>
  );
}

export function SignInPage() {
  return (
    <Layout title="Sign in · homekeeper">
      <p>
        <a href="/auth/login">Sign in with Google</a>
      </p>
    </Layout>
  );
}

export function HomePage({ name, email, csrf }: { name: string | null; email: string; csrf: string }) {
  return (
    <Layout title="homekeeper">
      <p>
        Signed in as {name ? `${name} (${email})` : email}.
      </p>
      <form method="post" action="/auth/logout">
        <input type="hidden" name="_csrf" value={csrf} />
        <button type="submit">Sign out</button>
      </form>
    </Layout>
  );
}

export function MessagePage({ title, message }: { title: string; message: string }) {
  return (
    <Layout title={`${title} · homekeeper`}>
      <p>{message}</p>
      <p>
        <a href="/signin">Back to sign-in</a>
      </p>
    </Layout>
  );
}
