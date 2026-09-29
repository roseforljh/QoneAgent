import remarkGfm from "remark-gfm";

/** Numeric ranges use a single tilde; explicit ~~deletions~~ remain supported. */
export function remarkQoneGfm(this: ThisParameterType<typeof remarkGfm>) {
  return remarkGfm.call(this, { singleTilde: false });
}
