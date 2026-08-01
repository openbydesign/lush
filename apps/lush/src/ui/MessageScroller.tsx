import type { ComponentProps, ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import type { MotionProps } from "motion/react";
import { motion, useReducedMotion } from "motion/react";
import {
  MessageScroller as ShadcnMessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem as ShadcnMessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from "../components/ui/message-scroller";

const MotionMessageScrollerItem = motion.create(ShadcnMessageScrollerItem);

export function MessageScroller(props: {
  children: ReactNode;
  resetKey: string;
  busy?: boolean;
  bottomInset?: number;
}) {
  const bottomInset = props.bottomInset ?? 0;

  return (
    <MessageScrollerProvider
      key={props.resetKey}
      autoScroll
      defaultScrollPosition="end"
      scrollEdgeThreshold={40}
    >
      <ShadcnMessageScroller className="relative min-h-0 flex-1">
        <MessageScrollerViewport className="h-full overflow-y-auto pr-3">
          <MessageScrollerContent
            aria-busy={props.busy}
            className="mx-auto flex max-w-3xl flex-col gap-8"
            style={{ paddingBottom: bottomInset + 32 }}
          >
            {props.children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          direction="end"
          className="bottom-4 border-[var(--color-border-strong)] bg-[var(--color-panel)] text-[var(--color-text)] shadow-lg shadow-[var(--shadow-menu)] hover:bg-[var(--color-panel-hover)]"
          size={props.busy ? "sm" : "icon-sm"}
          style={{ bottom: bottomInset + 16 }}
        >
          {props.busy ? (
            <>
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-[var(--color-brand)]" />
              <span>Streaming</span>
            </>
          ) : null}
          <ArrowDown aria-hidden="true" />
          <span className="sr-only">Jump to latest</span>
        </MessageScrollerButton>
      </ShadcnMessageScroller>
    </MessageScrollerProvider>
  );
}

export function MessageScrollerItem({
  animateEntrance = false,
  ...props
}: Omit<ComponentProps<typeof ShadcnMessageScrollerItem>, keyof MotionProps> & {
  animateEntrance?: boolean;
  children?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const shouldAnimate = animateEntrance && !reduceMotion;

  return (
    <MotionMessageScrollerItem
      initial={shouldAnimate ? { opacity: 0, scale: 0.98, y: 14 } : false}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      {...props}
    />
  );
}
