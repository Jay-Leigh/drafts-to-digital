local c=redis.call('HMGET',KEYS[1],'kh','st')
if not c[1] or c[1]~=ARGV[1] then return 2 end
if c[2]=='running' then return 0 end
redis.call('DEL',KEYS[1],KEYS[2]) return 1
