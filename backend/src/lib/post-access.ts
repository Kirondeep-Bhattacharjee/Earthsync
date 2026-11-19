import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { posts, profiles } from "../db/schema.js";
import { HttpError } from "./http.js";
import { areFriends, isBlockedEitherWay } from "./relationships.js";

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

// "Can this viewer see this post?" is the same rule as the posts list, and
// liking or commenting needs exactly that and nothing more:
//   - the author always can;
//   - public profile: anyone who is not blocked either way;
//   - private profile: friends only.
// It is checked on every call (never stored), so a profile that turns private,
// an unfriend or a block takes effect immediately.
//
// Every failure is a 404 (unlike the list route, which says 403 for a private
// profile): this route is addressed by post id, and a 403 would confirm that
// the id exists to someone who may not know it.
export async function requireVisiblePost(postId: number, viewerId: number) {
    const [post] = await db
        .select({
            id: posts.id,
            authorId: posts.authorId,
            visibility: profiles.visibility,
        })
        .from(posts)
        .innerJoin(profiles, eq(profiles.userId, posts.authorId))
        .where(eq(posts.id, postId))
        .limit(1);

    if (!post) {
        throw new HttpError(404, "Post not found");
    }

    if (post.authorId === viewerId) {
        return { id: post.id, authorId: post.authorId };
    }

    if (await isBlockedEitherWay(viewerId, post.authorId)) {
        throw new HttpError(404, "Post not found");
    }

    if (post.visibility === "private" && !(await areFriends(viewerId, post.authorId))) {
        throw new HttpError(404, "Post not found");
    }

    return { id: post.id, authorId: post.authorId };
}