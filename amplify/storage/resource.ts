import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'myStorageBucket',
  isDefault: true,
  access: (allow) => ({
    'projects/wilders-gap/*': [
      allow.groups(['wilders-gap']).to(['read', 'write', 'delete']),
    ],
  }),
});