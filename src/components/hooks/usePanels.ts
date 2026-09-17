import { useState } from "react";

export function usePanels() {
  const [showBranchPanel, setShowBranchPanel] = useState(false);
  const [showCommitPopover, setShowCommitPopover] = useState(false);
  const [showWorkflowsPanel, setShowWorkflowsPanel] = useState(false);
  const [showSimPanel, setShowSimPanel] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [panelsMenuOpen, setPanelsMenuOpen] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  return {
    showBranchPanel,
    setShowBranchPanel,
    showCommitPopover,
    setShowCommitPopover,
    showWorkflowsPanel,
    setShowWorkflowsPanel,
    showSimPanel,
    setShowSimPanel,
    showCommandPalette,
    setShowCommandPalette,
    panelsMenuOpen,
    setPanelsMenuOpen,
    showDiagnostics,
    setShowDiagnostics,
  };
}
