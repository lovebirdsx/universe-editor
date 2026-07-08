// esbuild's `text` loader turns `.html` imports into a string.
declare module '*.html' {
  const content: string
  export default content
}
