const histories = new Map<string, string[]>();

export const readComposerHistory = (paneId: string): string[] => [...(histories.get(paneId) ?? [])];

export const writeComposerHistory = (paneId: string, history: string[]): void => {
  histories.delete(paneId);
  histories.set(paneId, history.slice(-50));
  if (histories.size > 100) histories.delete(histories.keys().next().value!);
};
