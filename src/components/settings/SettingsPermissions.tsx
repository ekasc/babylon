import PermissionRulesSection from "../PermissionRulesSection";
import { SettingSection } from "./SettingSection";

export function SettingsPermissions() {
  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-fg">Permissions</h2>
      <p className="text-[13px] leading-5 text-dim mt-1">Control what the agent can do. Global, project and session scopes apply. Deny always wins.</p>
      <SettingSection title="Permission rules">
        <PermissionRulesSection />
      </SettingSection>
    </div>
  );
}
