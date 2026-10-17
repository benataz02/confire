import { SocialButtons as Buttons } from "@confire/ui/auth/SocialButtons.tsx";
import { authClient } from "../auth-client.ts";

// Both ends are /login: signed in, it is the dispatcher (it follows a safe `redirect`, or picks the
// user's place); a failure reads ?error=. Without errorCallbackURL Better Auth strands the user on its
// own error page.
export function SocialButtons({ redirect }: { redirect?: string }) {
  const back = `/login${redirect ? `?${new URLSearchParams({ redirect })}` : ""}`;
  return <Buttons signIn={(provider) => void authClient.signIn.social({ provider, callbackURL: back, errorCallbackURL: back })} />;
}
