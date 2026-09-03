const required = [
  "EXPO_PUBLIC_SUPABASE_URL",
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  "EXPO_PUBLIC_SENTRY_DSN",
  "EXPO_PUBLIC_UPDATE_MANIFEST_URL",
  "MIDTRANS_SERVER_KEY",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
];
const missing = required.filter((name) => !process.env[name]?.trim());
const failures = [...missing.map((name) => `missing:${name}`)];
if (process.env.MIDTRANS_IS_PRODUCTION !== "true") failures.push("MIDTRANS_IS_PRODUCTION_must_be_true");
if (process.env.PLATFORM_PAYMENT_MODEL !== "platform_wallet") failures.push("PLATFORM_PAYMENT_MODEL_must_be_platform_wallet");
for (const name of ["EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_UPDATE_MANIFEST_URL"]) {
  const value = process.env[name];
  if (value && !value.startsWith("https://")) failures.push(`${name}_must_use_https`);
}
if (failures.length) {
  console.error(`Production environment audit failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Production environment audit passed (secret values were not printed).");
