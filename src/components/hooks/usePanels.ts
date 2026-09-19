import { useState } from "react";

export function usePanels() {
  const [showCommitPopover, setShowCommitPopover] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  return {
    showCommitPopover,
    setShowCommitPopover,
    showCommandPalette,
    setShowCommandPalette,
  };
}
