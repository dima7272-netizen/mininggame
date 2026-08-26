import Image from 'next/image';

export function GameBrandIcon({ priority = false }: { priority?: boolean }) {
  return <Image className="brand-mark" src="/game-icon.png" alt="" width={96} height={96} priority={priority} unoptimized aria-hidden="true" />;
}
