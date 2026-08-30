/**
 * Tailwind 4 ships as a PostCSS plugin in its own package; the v3 style of
 * listing `tailwindcss` here fails with a message telling you to install this
 * one. There is no tailwind.config.js because v4 moved theme configuration
 * into CSS - see app/globals.css.
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
