export const isNearConversationBottom = (scrollHeight: number, scrollTop: number, clientHeight: number, tolerance = 56): boolean =>
  scrollHeight - scrollTop - clientHeight <= tolerance;
