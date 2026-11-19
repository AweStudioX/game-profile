import { createProfile } from '../lib/profile.mjs';
import { platformRuntime } from '../lib/platform-runtime.mjs';

export default { fetch: createProfile(platformRuntime) };
