import PermissionRulesSection from "../PermissionRulesSection";
import { SettingSection } from "./SettingSection";

export function SettingsPermissions() {
  return (
    <div>
      <h2 className="text-[24px] font-semibold tracking-[-0.015em]">Permissions</h2>
      <p className="text-[15px] leading-6 text-fg/60 mt-2">Control what the agent can do. Global, project and session scopes apply. Deny always wins.</p>
      <SettingSection title="Permission rules">
        <PermissionRulesSection />
      </SettingSection>
    </div>
  );
}
