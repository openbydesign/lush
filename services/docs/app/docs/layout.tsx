import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      githubUrl="https://github.com/openbydesign/lush"
      nav={{
        title: "Lush Docs"
      }}
      sidebar={{
        defaultOpenLevel: 1
      }}
    >
      {children}
    </DocsLayout>
  );
}
