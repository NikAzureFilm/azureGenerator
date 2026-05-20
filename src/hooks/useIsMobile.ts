import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 640;

function getIsMobile() {
  return typeof window !== 'undefined'
    ? window.innerWidth < MOBILE_BREAKPOINT
    : false;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(getIsMobile);

  useEffect(() => {
    const checkIsMobile = () => {
      setIsMobile(getIsMobile());
    };

    checkIsMobile();
    window.addEventListener('resize', checkIsMobile);

    return () => window.removeEventListener('resize', checkIsMobile);
  }, []);

  return isMobile;
}
