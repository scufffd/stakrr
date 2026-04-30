import { useEffect, useRef, useState } from 'react';

export function useReveal(threshold = 0.15) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);

  return { ref, visible };
}

const transforms = {
  up: 'translateY(48px)',
  left: 'translateX(-48px)',
  right: 'translateX(48px)',
  scale: 'scale(0.93)',
  fade: 'none',
};

export function revealStyle(visible, delay = 0, type = 'up') {
  return {
    opacity: visible ? 1 : 0,
    transform: visible ? 'none' : transforms[type] || transforms.up,
    transition: `opacity 0.75s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 0.75s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
    willChange: 'opacity, transform',
  };
}
