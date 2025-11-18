import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { storage } from './storage/resource';


/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  storage,
});

// Disable public self sign-up so only admins can create users.
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.addPropertyOverride(
  'AdminCreateUserConfig.AllowAdminCreateUserOnly',
  true
);
