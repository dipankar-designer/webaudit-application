import type { ReactNode } from 'react';
import { Accessibility, ClipboardList, Code2, FileCode2, Gauge, Globe, Image, Layers, Link2Off, Lock, MonitorSmartphone, Search } from 'lucide-react';
import type { Category } from '@wpcg/shared';

/** One icon per check category, shared by the landing page and the scan results explorer. */
export function categoryIcon(c: Category, className = 'size-5'): ReactNode {
  const props = { className, 'aria-hidden': true } as const;
  switch (c) {
    case 'availability':
      return <Globe {...props} />;
    case 'html':
      return <FileCode2 {...props} />;
    case 'accessibility':
      return <Accessibility {...props} />;
    case 'seo':
      return <Search {...props} />;
    case 'security':
      return <Lock {...props} />;
    case 'links':
      return <Link2Off {...props} />;
    case 'images':
      return <Image {...props} />;
    case 'javascript':
      return <Code2 {...props} />;
    case 'responsive':
      return <MonitorSmartphone {...props} />;
    case 'visual':
      return <Layers {...props} />;
    case 'performance':
      return <Gauge {...props} />;
    case 'forms':
      return <ClipboardList {...props} />;
  }
}
