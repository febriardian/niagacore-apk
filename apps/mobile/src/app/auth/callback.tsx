import { Redirect } from "expo-router";

// Supabase finishes invite and email-confirmation links on this native route.
// AuthProvider consumes the complete initial URL, establishes the session, and
// the root screen then shows staff activation or the signed-in workspace.
export default function AuthCallbackRoute() {
  return <Redirect href="/" />;
}
