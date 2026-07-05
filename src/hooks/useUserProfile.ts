import { useCallback, useState } from 'react';
import {
  DEFAULT_COMPANY,
  loadUserProfile,
  saveUserProfile,
  type UserProfile,
} from '../email/profile';

export function useUserProfile(): {
  profile: UserProfile;
  setProfile: (next: UserProfile) => void;
  /** 온보딩 필요 여부 — 이름 미설정 */
  needsOnboarding: boolean;
} {
  const [profile, setProfileState] = useState<UserProfile>(loadUserProfile);

  const setProfile = useCallback((next: UserProfile) => {
    const clean: UserProfile = {
      ...next,
      name: next.name.trim(),
      email: next.email.trim(),
      company: next.company.trim() || DEFAULT_COMPANY,
    };
    saveUserProfile(clean); // 동기 저장 → 이후 렌더의 loadUserProfile()도 최신값
    setProfileState(clean);
  }, []);

  return { profile, setProfile, needsOnboarding: !profile.name.trim() };
}
