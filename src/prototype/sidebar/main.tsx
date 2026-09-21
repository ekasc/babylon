import { createRoot } from "react-dom/client";
import "../../styles.css";
import { SidebarPrototype } from "./SidebarPrototype";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");
createRoot(rootEl).render(<SidebarPrototype />);
