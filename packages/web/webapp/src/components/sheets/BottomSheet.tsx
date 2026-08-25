import { Drawer } from "@base-ui/react/drawer";
import type { ReactNode } from "react";

export function BottomSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
      <Drawer.VirtualKeyboardProvider>
        <Drawer.Portal>
          <Drawer.Backdrop className="sheet-backdrop" />
          <Drawer.Viewport className="sheet-viewport">
            <Drawer.Popup className="bottom-sheet">
              <div className="sheet-grabber" aria-hidden="true" />
              <header className="sheet-header"><Drawer.Title>{title}</Drawer.Title><Drawer.Close className="icon-button" aria-label="Close">×</Drawer.Close></header>
              <Drawer.Content className="sheet-content">{children}</Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.VirtualKeyboardProvider>
    </Drawer.Root>
  );
}
