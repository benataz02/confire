import { SocialButtons as Buttons } from "@confire/ui/auth/SocialButtons.tsx";
import { authClient } from "../auth-client.ts";

// Always the apex dispatcher — it is what knows whether this user has a company yet. Failures go
// to login, which reads ?error=; without this Better Auth strands the user on its own error page.
const urls = { callbackURL: "/", errorCallbackURL: "/login" };

export function SocialButtons() {
  return <Buttons signIn={(provider) => void authClient.signIn.social({ provider, ...urls })} />;
}
