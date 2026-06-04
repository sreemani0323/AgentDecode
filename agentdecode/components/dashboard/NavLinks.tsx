'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { FolderOpen, AlertCircle, Settings, Users, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

const links = [
  { href: '/dashboard', label: 'Projects', icon: FolderOpen },
  { href: '/dashboard/issues', label: 'Issues', icon: AlertCircle },
  { href: '/dashboard/team', label: 'Team', icon: Users },
  { href: '/dashboard/docs', label: 'Docs', icon: BookOpen },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export default function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {links.map((link) => {
        const isActive =
          link.href === '/dashboard'
            ? pathname === '/dashboard'
            : pathname.startsWith(link.href);

        const Icon = link.icon;

        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors',
              isActive
                ? 'bg-primary/10 text-primary border-l-2 border-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted border-l-2 border-transparent'
            )}
          >
            <Icon className="h-4 w-4" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
