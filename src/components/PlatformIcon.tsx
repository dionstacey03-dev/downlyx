import React from 'react';
import {
  Youtube,
  Instagram,
  Music2,
  Share2,
  MessageSquare,
  FileVideo,
  AlertCircle,
} from 'lucide-react';
import type { PlatformId } from '../types/media.ts';

interface PlatformIconProps {
  platform: PlatformId;
  className?: string;
}

export const PlatformIcon: React.FC<PlatformIconProps> = ({
  platform,
  className = 'h-4 w-4',
}) => {
  switch (platform) {
    case 'youtube':
      return <Youtube className={`${className} text-rose-500`} aria-hidden="true" />;
    case 'instagram':
      return <Instagram className={`${className} text-pink-500`} aria-hidden="true" />;
    case 'tiktok':
      return <Music2 className={`${className} text-[#22D3EE]`} aria-hidden="true" />;
    case 'facebook':
      return <Share2 className={`${className} text-blue-500`} aria-hidden="true" />;
    case 'x':
      return <MessageSquare className={`${className} text-[#8B5CF6]`} aria-hidden="true" />;
    case 'direct':
      return <FileVideo className={`${className} text-emerald-500`} aria-hidden="true" />;
    default:
      return <AlertCircle className={`${className} text-amber-500`} aria-hidden="true" />;
  }
};
