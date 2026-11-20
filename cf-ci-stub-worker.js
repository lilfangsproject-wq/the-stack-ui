/** CI stub — product UI is GitHub Pages, not this Worker. */
export default {
  async fetch() {
    return new Response("ai-workspace static CI stub\n", { status: 200 });
  },
};
