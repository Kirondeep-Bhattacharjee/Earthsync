// Shape of a post as returned by routes/posts.ts (toPostResponse).
export type PostMedia = {
  type: "image" | "video"
  url: string
  thumbUrl: string | null
  width: number | null
  height: number | null
  durationSeconds: number | null
}

export type Post = {
  id: number
  caption: string | null
  createdAt: string
  media: PostMedia
}

export type PostsPage = {
  posts: Post[]
  nextCursor: number | null
}

// Keep in sync with lib/post-media.ts on the backend.
export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const POST_VIDEO_MAX_BYTES = 100 * 1024 * 1024
export const POST_VIDEO_MAX_SECONDS = 30
export const POST_CAPTION_MAX = 500
