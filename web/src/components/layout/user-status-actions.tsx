import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { Dropdown, Tooltip } from "antd";
import { BookOpen, Keyboard, LogOut, Puzzle, Settings2, WalletCards } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { type AccountBalance, getAccountBalance } from "@/services/api/account";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const [balance, setBalance] = useState<AccountBalance | null>(null);
    const [loggingOut, setLoggingOut] = useState(false);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass =
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const gitHubClassName = "size-7 text-base";
    const gitHubStyle = iconStyle;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    useEffect(() => {
        let active = true;
        const refresh = () =>
            void getAccountBalance()
                .then((value) => active && setBalance(value))
                .catch(() => active && setBalance(null));
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
            active = false;
            window.removeEventListener("focus", refresh);
        };
    }, []);

    const logout = async () => {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            await fetch("/api/auth/logout", { method: "POST", headers: { Accept: "application/json" } });
        } finally {
            window.location.assign("/login");
        }
    };

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            <Dropdown
                trigger={["click"]}
                disabled={!balance}
                menu={{
                    items: [{ key: "recharge", label: "去充值", icon: <WalletCards className="size-4" /> }],
                    onClick: () => balance?.rechargeUrl && window.open(balance.rechargeUrl, "_blank", "noopener,noreferrer"),
                }}
            >
                <button
                    type="button"
                    className="mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-stone-600 transition-colors hover:bg-black/5 dark:text-stone-300 dark:hover:bg-white/10"
                    style={iconStyle}
                    title={balance ? "点击充值" : "余额读取中"}
                >
                    <WalletCards className="size-3.5" />
                    <span>{balance ? formatBalance(balance) : "余额 --"}</span>
                </button>
            </Dropdown>
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label={t("topNav.docs")} title={t("topNav.docs")}>
                <BookOpen className="size-4" />
            </a>
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")} title={t("navigation.config")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AnimatedThemeToggler
                theme={theme}
                onThemeChange={setTheme}
                className={naturalIconClass}
                style={iconStyle}
                aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
                title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")}
            />
            <VersionReleaseModal style={versionStyle} />
            <GitHubLink className={cn("bg-transparent hover:bg-transparent dark:hover:bg-transparent", gitHubClassName)} style={gitHubStyle} />
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            <button type="button" className={naturalIconClass} style={iconStyle} disabled={loggingOut} onClick={() => void logout()} aria-label="退出登录" title="退出登录">
                <LogOut className="size-4" />
            </button>
        </div>
    );
}

function formatBalance(balance: AccountBalance) {
    if (balance.quotaDisplayType === "TOKENS") return `余额 ${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(balance.quota)}`;
    const usd = balance.quota / balance.quotaPerUnit;
    const rate = balance.quotaDisplayType === "CNY" ? balance.usdExchangeRate : balance.quotaDisplayType === "CUSTOM" ? balance.customCurrencyExchangeRate : 1;
    const symbol = balance.quotaDisplayType === "CNY" ? "¥" : balance.quotaDisplayType === "CUSTOM" ? balance.customCurrencySymbol : "$";
    return `余额 ${symbol}${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd * rate)}`;
}
