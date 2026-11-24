redis.call('ZREM',KEYS[3],ARGV[7]) redis.call('ZREM',KEYS[5],ARGV[7])
local c=redis.call('HMGET',KEYS[1],'st','a')
if c[1]~='running' then return c[1] or 'gone' end
if ARGV[2]~='succeeded' and c[2]~=ARGV[1] then return 'stale' end
if ARGV[2]=='succeeded' then redis.call('SET',KEYS[2],ARGV[4],'EX',ARGV[6]) end
redis.call('HSET',KEYS[1],'st',ARGV[2],'e',ARGV[3],'f',ARGV[5],'fa',ARGV[1],'rb',string.len(ARGV[4]))
redis.call('EXPIRE',KEYS[1],ARGV[6]) redis.call('HINCRBY',KEYS[4],ARGV[2],1) redis.call('EXPIRE',KEYS[4],2592000) return 'stored'
