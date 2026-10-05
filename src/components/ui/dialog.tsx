'use client';

import * as React from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-[#1d1b18]/30 duration-150 supports-backdrop-filter:backdrop-blur-[2px]',
        className
      )}
      {...props}
    />
  );
}

// v2: a centered card from sm up; on phones the same dialog rises from the
// bottom edge like the app's sheets. "center" keeps it centered everywhere
// (the media lightbox needs that).
const DIALOG_POSITION = {
  sheet:
    'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[24px] max-sm:data-open:slide-in-from-bottom max-sm:data-closed:slide-out-to-bottom sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:max-w-sm sm:max-h-[calc(100vh-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[24px] sm:data-open:zoom-in-95 sm:data-closed:zoom-out-95',
  center:
    'top-1/2 left-1/2 max-w-[calc(100%-2rem)] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[24px] sm:max-w-sm data-open:zoom-in-95 data-closed:zoom-out-95',
};

function DialogContent({
  className,
  children,
  showCloseButton = true,
  position = 'sheet',
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  position?: keyof typeof DIALOG_POSITION;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'bg-popover text-popover-foreground ring-border data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed z-50 grid w-full gap-4 overflow-y-auto p-6 text-sm shadow-[0_24px_60px_rgb(0_0_0/0.18)] ring-1 duration-200 ease-out outline-none',
          DIALOG_POSITION[position],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        '-mx-6 -mb-6 flex flex-col-reverse gap-2 border-t px-6 pt-4 pb-5 sm:flex-row sm:justify-end sm:rounded-b-[24px]',
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        'font-heading pr-8 text-xl leading-tight font-extrabold tracking-[-0.01em]',
        className
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3',
        className
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
