/** @type {import('next').NextConfig} */
export default {
  // This console runs locally against the production database and is never
  // deployed, so there is no image host allowlist or asset prefix to configure.
  // Keeping it undeployed is a deliberate security decision, not an omission:
  // it means the Supabase secret key stays on one machine and there is no
  // hosted surface to authenticate.
  reactStrictMode: true,
};
