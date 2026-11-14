import { Hono } from "hono";
import { type AppContext, auth, requireUser } from "./auth";
import { HomePage, PrivacyPage, SignInPage } from "./pages";
import { csrfToken } from "./session";

const app = new Hono<AppContext>();

// Public routes: the sign-in page, the privacy policy and the sign-in flow itself.
app.get("/signin", (c) => c.html(<SignInPage />));
app.get("/privacy", (c) => c.html(<PrivacyPage />));
app.route("/auth", auth);

// Everything below needs a signed-in, allow-listed user.
app.use("*", requireUser);

app.get("/", async (c) => {
  const user = c.get("user");
  const csrf = await csrfToken(c.env.SESSION_KEY, user.id);
  return c.html(<HomePage name={user.display_name} email={user.email} csrf={csrf} />);
});

export default app;
