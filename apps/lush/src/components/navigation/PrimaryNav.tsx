import {
  BotIcon,
  BriefcaseIcon,
  CodeXmlIcon,
  HomeIcon,
  MessageCircleIcon,
  PackageOpenIcon
} from "lucide-react";
import { routes } from "../../lib/app-data";
import { NavLink } from "react-router-dom";

export function PrimaryNav() {
  const items = [
    { href: "/sessions", label: "Home", icon: HomeIcon },
    ...routes.map((route) => ({
      href: route.href,
      label: route.label,
      icon:
        route.href === "/chat"
          ? MessageCircleIcon
          : route.href === "/code"
            ? CodeXmlIcon
            : route.href === "/work"
              ? BriefcaseIcon
              : route.href === "/agents"
                ? BotIcon
                : PackageOpenIcon
    }))
  ];

  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        const Icon = item.icon;
        return (
        <NavLink
          key={item.href}
          to={item.href}
          className={({ isActive }) => `flex items-center gap-1.5 rounded-lg px-3 py-1 text-[10px] font-medium transition ${
            isActive
              ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]"
              : "text-[var(--color-subtle)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          }`}
        >
          <Icon className="size-3.5" />
          {item.label}
        </NavLink>
        );
      })}
    </div>
  );
}
