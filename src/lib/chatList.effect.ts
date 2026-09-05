import * as Effect from "effect/Effect";
import { resolveChatListAnchoredEndSpace, type ChatListAnchoredEndSpace, type ChatListAnchorOptions } from "./chatList";

export const resolveChatListAnchoredEndSpaceEffect = <Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
  options?: ChatListAnchorOptions,
): Effect.Effect<ChatListAnchoredEndSpace | undefined> =>
  Effect.sync(() => resolveChatListAnchoredEndSpace(items, anchorId, getAnchorId, options));
