import { MyContext } from "src/types";
import {
  Arg,
  Ctx,
  Field,
  FieldResolver,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  Root,
  UseMiddleware,
} from "type-graphql";
import { getConnection } from "typeorm";
import { Post } from "../entities/Post";
import { Upvote } from "../entities/Upvote";
import { User } from "../entities/User";
import { isAuth } from "../middleware/isAuth";

@InputType()
class PostInput {
  @Field()
  title: string;

  @Field()
  text: string;
}

@ObjectType()
class PaginatedPosts {
  @Field(() => [Post])
  posts: Post[];

  @Field()
  hasMore: boolean;
}

@Resolver(Post)
export class PostResolver {
  @FieldResolver(() => String)
  textSnippet(@Root() root: Post) {
    const MAX_LENGTH = 100;
    if (root.text.length > MAX_LENGTH - 3) {
      return root.text.slice(0, MAX_LENGTH - 3) + "...";
    }
    return root.text.slice(0, MAX_LENGTH);
  }

  @FieldResolver(() => User)
  async creator(@Root() post: Post, @Ctx() { userLoader }: MyContext) {
    return userLoader.load(post.creatorId);
  }

  @FieldResolver(() => Boolean, { nullable: true })
  async voteStatus(
    @Root() post: Post,
    @Ctx() { upvoteLoader, req }: MyContext
  ): Promise<boolean | null> {
    if (!req.session.userId) {
      return null;
    }
    const upvote = await upvoteLoader.load({
      postId: post.id,
      userId: req.session.userId,
    });

    return upvote ? upvote.isPositive : null;
  }

  // QUERIES
  @Query(() => PaginatedPosts)
  async posts(
    @Arg("limit", () => Int) limit: number,
    @Arg("cursor", () => String, { nullable: true }) cursor: string | null
  ): Promise<PaginatedPosts> {
    const realLimit = Math.min(50, limit);
    const realLimitPlusOne = realLimit + 1;

    const replacements: any[] = [realLimitPlusOne];

    if (cursor) {
      replacements.push(new Date(parseInt(cursor)));
    }

    const posts = await getConnection().query(
      `
    select p.*
    from post p
    ${cursor ? `where p."createdAt" < $2` : ""}
    order by p."createdAt" DESC
    limit $1
    `,
      replacements
    );

    return {
      posts: posts.slice(0, realLimit),
      hasMore: posts.length === realLimitPlusOne,
    };
  }

  @Query(() => Post, { nullable: true })
  async post(@Arg("id", () => Int) id: number): Promise<Post | undefined> {
    const post = await Post.findOne(id);
    return post;
  }

  // MUTATIONS
  @Mutation(() => Post)
  @UseMiddleware(isAuth)
  async vote(
    @Arg("postId", () => Int) postId: number,
    @Arg("isPositive", () => Boolean) isPositive: boolean,
    @Ctx() { req }: MyContext
  ): Promise<Post | undefined> {
    const userId = req.session.userId;
    const value = isPositive ? 1 : -1;

    const upvote = await Upvote.findOne({ where: { postId, userId } });

    // The user has voted on the post before
    // and the user is voting the same thing again
    if (upvote && upvote.isPositive != isPositive) {
      await getConnection().transaction(async (tm) => {
        await tm.query(
          `
        update upvote
        set "isPositive" = $1
        where "postId" = $2 and "userId" = $3
        `,
          [isPositive, postId, userId]
        );

        await tm.query(
          `
          update post
          set points = points + $1
          where id = $2
          `,
          [value * 2, postId]
        );
      });

      // The user hasnt voted on the post before
    } else if (!upvote) {
      await getConnection().transaction(async (tm) => {
        await tm.query(
          `
    insert into upvote ("userId", "postId", "isPositive")
    values ($1,$2,$3)
        `,
          [userId, postId, isPositive]
        );

        await tm.query(
          `
    update post
    set points = points + $1
    where id = $2
        `,
          [value, postId]
        );
      });
    }

    const newPost = await getConnection().query(
      `
    select p.*,
    ${
      req.session.userId
        ? '(select "isPositive" from upvote where "userId" = $1 and "postId" = p.id) "voteStatus"'
        : 'null as "voteStatus"'
    }
    from post p
    where p.id = $2
    `,
      [userId, postId]
    );

    return newPost[0];
  }

  @Mutation(() => Post)
  @UseMiddleware(isAuth)
  async createPost(
    @Arg("options") options: PostInput,
    @Ctx() { req }: MyContext
  ): Promise<Post> {
    return Post.create({ ...options, creatorId: req.session.userId }).save();
  }

  @Mutation(() => Post, { nullable: true })
  @UseMiddleware(isAuth)
  async updatePost(
    @Arg("id", () => Int) id: number,
    @Arg("title") title: string,
    @Arg("text") text: string,
    @Ctx() { req }: MyContext
  ): Promise<Post | null> {
    const result = await getConnection()
      .createQueryBuilder()
      .update(Post)
      .set({ title, text })
      .where('id = :id and "creatorId" = :creatorId', {
        id,
        creatorId: req.session.userId,
      })
      .returning("*")
      .execute();

    return result.raw[0];
  }

  @Mutation(() => Boolean)
  @UseMiddleware(isAuth)
  async deletePost(
    @Arg("id", () => Int) id: number,
    @Ctx() { req }: MyContext
  ): Promise<boolean> {
    const post = await Post.findOne(id);
    if (!post) {
      return false;
    }
    if (post.creatorId !== req.session.userId) {
      throw new Error("not authorized");
    }

    await Upvote.delete({ postId: id });
    await Post.delete(id);

    return true;
  }
}
