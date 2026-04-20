import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SettingsControls } from "@/components/settings-controls";
import { Button } from "@/components/ui/button";
import type { ThemeOption } from "@/types/patch";

type Props = {
  theme: ThemeOption;
  onThemeChange: (t: ThemeOption) => void;
};

export function SettingsPage({ theme, onThemeChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-2xl pb-12">
      <div className="mb-6">
        <Button type="button" variant="ghost" size="sm" className="gap-2 px-0" asChild>
          <Link to="/">
            <ArrowLeft className="h-4 w-4" />
            {t("settings.back")}
          </Link>
        </Button>
      </div>
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
      <SettingsControls theme={theme} onThemeChange={onThemeChange} />
    </div>
  );
}
