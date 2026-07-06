import { Context, Schema, h, Logger, Session } from 'koishi'

export const name = 'vote-to-ban'
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`

export interface Config {
  voteGroup: string,
  allowList: string[],
  threshold: string,
  timeout: number
}

export const Config: Schema<Config> = Schema.object({
  voteGroup: Schema.string().description('投票表决群'),
  allowList: Schema.array(String).description('白名单用户'),
  threshold: Schema.string().description('表决阈值').default('5:2').pattern(/^\d+:\d+$/),
  timeout: Schema.number().description('超时时间').min(0),
})

interface Vote {
  session: Session,
  targetId: string,
  targetName: string,
  messageId: string,
  duration: number,
  approve: Set<string>,
  reject: Set<string>,
  timer?: NodeJS.Timeout
}

export function apply(ctx: Context, config: Config) {
  const logger = new Logger('vote-to-ban')
  const voteMap = new Map<string, Vote>()

  const finishVote = (voteKey: string, vote: Vote, result: 'approve' | 'reject' | 'timeout', replySession?: Session, prefix = '') => {
    if (vote.timer) clearTimeout(vote.timer)
    voteMap.delete(voteKey)
    const { session, targetId, targetName, duration } = vote
    const guildId = session.guildId
    if (!session.bot || !guildId) return
    const targetGroup = config.voteGroup || guildId
    const sendMsg = (msg: string) => replySession ? replySession.send(prefix + (prefix ? '\n' : '') + msg).catch(logger.error) : session.bot.sendMessage(targetGroup, msg).catch(logger.error)
    if (result === 'timeout') return sendMsg(`投票超时，未对 ${targetName} 执行操作`)
    if (result === 'reject') return sendMsg(`投票否决，未对 ${targetName} 执行操作`)
    const action = duration > 0 ? session.bot.muteGuildMember(guildId, targetId, duration * 60000) : session.bot.kickGuildMember(guildId, targetId)
    action.then(() => sendMsg(`投票通过，已${duration > 0 ? `禁言${duration}分钟` : '踢出'} ${targetName}`)).catch(logger.error)
  }

  ctx.command('vote [duration:number]').action(async ({ session }, duration) => {
    if (!session?.guildId || !session.userId) return
    if (config.allowList && config.allowList.length > 0) if (!config.allowList.includes(session.userId)) return
    if (config.voteGroup) try { await session.bot.getGuildMember(config.voteGroup, session.userId) } catch (e) { return; }
    const quote = session.quote
    if (!quote || !quote.user || !quote.user.id) return
    const guildId = session.guildId
    duration = (!duration || isNaN(duration)) ? 0 : duration
    const targetId = quote.user.id
    if (targetId === session.selfId) return
    const voteKey = `${guildId}-${targetId}`
    if (voteMap.has(voteKey)) return
    let targetName = quote.user.name || targetId
    try {
      const [botMember, targetMember] = await Promise.all([session.bot.getGuildMember(guildId, session.selfId), session.bot.getGuildMember(guildId, targetId)])
      targetName = targetMember.nick || targetMember.user?.name || targetName
      if ((botMember as any).role === 'member') return
      if ((targetMember as any).role !== 'member') return
    } catch (e) {
      return
    }
    const [appLimit, rejLimit] = config.threshold.split(':').map(Number)
    const targetGroup = config.voteGroup || guildId
    const messageText = `用户: ${targetName}\n操作: ${duration > 0 ? `禁言${duration}分钟` : '踢出'}\n规则: ${appLimit}人同意 / ${rejLimit}人反对 (${config.timeout > 0 ? `限时${config.timeout}分钟` : '不限时'})\n请引用回复本消息: [+1/y/支持/同意] 或 [-1/n/反对/拒绝]`
    const vote: Vote = { session, targetId, targetName, messageId: '', duration, approve: new Set(), reject: new Set() }
    if (config.voteGroup && config.voteGroup !== guildId) {
      if (session.bot.internal?.sendGroupForwardMsg) {
        await session.bot.internal.sendGroupForwardMsg(Number(targetGroup), [{ type: 'node', data: { name: targetName, uin: targetId, content: quote.content } }]).catch(() => {})
      } else {
        await session.bot.sendMessage(targetGroup, `[转发] ${targetName}:\n${quote.content}`).catch(() => {})
      }
    }
    const result = await session.bot.sendMessage(targetGroup, messageText).catch(logger.error)
    const msgId = (Array.isArray(result) ? result[0] : result) || ''
    if (!msgId) return
    vote.messageId = msgId
    if (config.timeout > 0) {
      vote.timer = setTimeout(() => {
        if (vote.approve.size >= appLimit) finishVote(voteKey, vote, 'approve')
        else if (vote.reject.size >= rejLimit) finishVote(voteKey, vote, 'reject')
        else finishVote(voteKey, vote, 'timeout')
      }, config.timeout * 60000)
    }
    voteMap.set(voteKey, vote)
  })

  ctx.middleware((session, next) => {
    const { userId, quote, guildId, content } = session
    const targetGroup = config.voteGroup || guildId
    if (!userId || !quote?.id || !guildId || guildId !== targetGroup) return next()
    if (config.allowList && config.allowList.length > 0) if (!config.allowList.includes(userId)) return next()
    const voteEntry = [...voteMap.entries()].find(([, v]) => v.messageId === quote.id)
    if (!voteEntry) return next()
    const [voteKey, vote] = voteEntry
    const msgText = content?.trim().toLowerCase() || ''
    const isApprove = ['+1', 'y', 'yes', '支持', '同意'].includes(msgText)
    const isReject = ['-1', 'n', 'no', '反对', '拒绝'].includes(msgText)
    if (!isApprove && !isReject) return next()
    if (isApprove) {
      if (vote.approve.has(userId)) return
      vote.reject.delete(userId)
      vote.approve.add(userId)
    } else {
      if (vote.reject.has(userId)) return
      vote.approve.delete(userId)
      vote.reject.add(userId)
    }
    const [appLimit, rejLimit] = config.threshold.split(':').map(Number)
    if (vote.approve.size >= appLimit) return finishVote(voteKey, vote, 'approve', session, h.quote(quote.id).toString())
    if (vote.reject.size >= rejLimit) return finishVote(voteKey, vote, 'reject', session, h.quote(quote.id).toString())
  })

  ctx.on('dispose', () => {
    voteMap.forEach(v => v.timer && clearTimeout(v.timer))
    voteMap.clear()
  })
}
