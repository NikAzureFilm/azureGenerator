// Empty PostCSS config so this app does NOT inherit the parent Vite project's
// tailwind/postcss setup (postcss-load-config otherwise searches up the tree).
// The admin dashboard uses plain CSS (app/globals.css).
const config = { plugins: {} };
export default config;
