import { Redirect } from "expo-router";

// Keep password-recovery deep links routable while AuthProvider exchanges the
// token and switches the root screen to the new-password form.
export default function AuthResetRoute() {
  return <Redirect href="/" />;
}
