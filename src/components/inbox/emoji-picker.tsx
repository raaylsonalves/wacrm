'use client';

import { useState } from 'react';
import { Smile } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// A curated set instead of a full emoji library (~300 KB): the emojis
// people actually use in customer chats, grouped like WhatsApp's tabs.
const GROUPS: { key: string; icon: string; emojis: string }[] = [
  {
    key: 'smileys',
    icon: '😀',
    emojis:
      '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👻 💀 🤖 💩',
  },
  {
    key: 'gestures',
    icon: '👍',
    emojis:
      '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🫶 👀 🧠 🗣️ 👤 👥 🙋 🙆 🙅 🤷 🤦 💁 🙇',
  },
  {
    key: 'hearts',
    icon: '❤️',
    emojis:
      '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ✨ ⭐ 🌟 💫 🔥 💯 💥 🎉 🎊 🎁 🏆 🥇',
  },
  {
    key: 'objects',
    icon: '💼',
    emojis:
      '💼 📱 💻 🖥️ ⌨️ 🖨️ 📞 ☎️ 📧 📨 📩 📦 📋 📌 📍 📎 🗂️ 📁 📅 📆 🗓️ ⏰ ⏳ ⌛ 💰 💵 💳 🧾 🛒 🏠 🏢 🚗 🚚 ✈️ 🔑 🔒 🔓 🔧 🛠️ ⚙️ 💡 📝 ✏️ 📊 📈 📉',
  },
  {
    key: 'symbols',
    icon: '✅',
    emojis:
      '✅ ☑️ ✔️ ❌ ❎ ⚠️ 🚫 ❓ ❗ ‼️ ⁉️ 💬 🗨️ 🔔 🔕 📢 ➡️ ⬅️ ⬆️ ⬇️ ↩️ 🔄 🆗 🆕 🆓 🔝 🔜 ⏩ ⏪ ▶️ ⏸️ 🟢 🟡 🔴 🔵 ⚪ ⚫',
  },
  {
    key: 'food',
    icon: '☕',
    emojis:
      '☕ 🍵 🥤 🍺 🍷 🥂 🍾 🍕 🍔 🍟 🌭 🥪 🌮 🍣 🍝 🥗 🍰 🎂 🧁 🍫 🍩 🍪 🍎 🍌 🍓 🍇 🥑 🌽 🥩 🍗',
  },
];

const RECENT_KEY = 'inbox:recent-emojis';
const RECENT_MAX = 16;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((e) => typeof e === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function pushRecent(emoji: string): string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(
    0,
    RECENT_MAX
  );
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private window — recents just don't persist */
  }
  return next;
}

export function EmojiPicker({
  onPick,
  disabled,
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Inbox.composer');
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [tab, setTab] = useState<string>('smileys');

  const groups = recent.length
    ? [{ key: 'recent', icon: '🕘', emojis: recent.join(' ') }, ...GROUPS]
    : GROUPS;
  const active = groups.find((g) => g.key === tab) ?? groups[0];

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          const r = readRecent();
          setRecent(r);
          setTab(r.length ? 'recent' : 'smileys');
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        title={t('emoji')}
        aria-label={t('emoji')}
        className="text-muted-foreground hover:text-foreground inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Smile className="h-5 w-5" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 gap-2 p-2">
        <div className="border-border flex gap-1 border-b pb-1">
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setTab(g.key)}
              aria-label={t(`emojiGroups.${g.key}`)}
              title={t(`emojiGroups.${g.key}`)}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md text-lg',
                active.key === g.key
                  ? 'bg-muted'
                  : 'opacity-60 hover:opacity-100'
              )}
            >
              {g.icon}
            </button>
          ))}
        </div>
        <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto">
          {active.emojis.split(' ').map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                setRecent(pushRecent(e));
                onPick(e);
              }}
              className="hover:bg-muted flex h-8 w-8 items-center justify-center rounded-md text-xl"
            >
              {e}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
