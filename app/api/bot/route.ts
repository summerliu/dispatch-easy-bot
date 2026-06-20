import { Bot, webhookCallback } from "grammy";
import { createClient } from "@supabase/supabase-js";

// 1. 初始化工具
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// 輔助函式：從 @username 尋找或建立資料庫使用者
async function getOrCreateUserByUsername(username: string) {
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("binding_code", username)
    .single();

  if (user) return user;

  const { data: newUser } = await supabase
    .from("users")
    .insert({ name: username, binding_code: username, role: "staff" })
    .select()
    .single();

  return newUser;
}

// 2. 監聽 /new [任務] @群組人 (主管派工)
bot.command("new", async (ctx) => {
  try {
    const text = ctx.match?.trim();
    if (!text) {
      return ctx.reply("❌ 格式錯誤！使用範例：`/new 維修A棟冷氣 @xiaoming`", { parse_mode: "Markdown" });
    }

    const mentionMatch = text.match(/(.*)\s+@(\w+)/);
    if (!mentionMatch) {
      return ctx.reply("❌ 格式錯誤！請記得在任務後面加上空格與 `@被指派人`。");
    }

    const taskTitle = mentionMatch[1].trim();
    const username = mentionMatch[2].trim();

    const staffUser = await getOrCreateUserByUsername(username);
    if (!staffUser) return ctx.reply("❌ 系統初始化員工資料失敗。");

    // 建立任務，狀態設為 active
    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        title: taskTitle,
        assignee_id: staffUser.id,
        status: "active",
      })
      .select()
      .single();

    if (error || !task) {
      return ctx.reply(`❌ 任務建立失敗：${error?.message}`);
    }

    await ctx.reply(
      `📌 *【新任務派發】*\n\n` +
      `📝 任務：${taskTitle}\n` +
      `👤 負責人：@${username}\n\n` +
      `⚡️ 任務已自動生效。請 @${username} 完成任務後，*「回覆」此訊息並上傳現場照片*！`,
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    await ctx.reply(`💥 發生錯誤：${err.message}`);
  }
});

// 3. 監聽員工上傳照片回報（員工回報完工）
bot.on("message:photo", async (ctx) => {
  try {
    const replyToMessage = ctx.message.reply_to_message;
    if (!replyToMessage || !replyToMessage.text) return;

    // 從員工回覆的那則任務小卡中，精準抓出「任務名稱」
    const taskMatch = replyToMessage.text.match(/📝 任務：(.*)\n/);
    if (!taskMatch) return;
    const taskTitle = taskMatch[1].trim();

    // 更新為 completed (即便失敗也不影響下一步通知發送，極致防呆)
    await supabase
      .from("tasks")
      .update({ status: "completed" })
      .eq("title", taskTitle)
      .neq("status", "closed");

    // 發出完工審核通知
    await ctx.reply(
      `📸 *【員工完工回報】*\n\n` +
      `📝 待審核任務：${taskTitle}\n` +
      `請主管確認現場照片。若審核通過，請*「回覆」此條通知*並輸入 \`/ok\` 結案。`, 
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    console.error("處理照片失敗:", err);
  }
});

// 4. 監聽 /ok (主管直接回覆 Bot 的完工通知訊息，打 /ok 即可結案)
bot.command("ok", async (ctx) => {
  try {
    const replyToMessage = ctx.message.reply_to_message;
    
    // 防呆：如果主管沒有回覆訊息，就改用撈資料庫最新一筆待審核的 fallback 方案
    if (!replyToMessage || !replyToMessage.text) {
      const { data: fallbackTask } = await supabase
        .from("tasks")
        .update({ status: "closed" })
        .eq("status", "completed")
        .order("id", { ascending: false })
        .limit(1)
        .select()
        .maybeSingle();

      if (fallbackTask) {
        return ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${fallbackTask.title}*」已由主管審核通過，順利結案！`);
      }
      return ctx.reply("❌ 請長按「回覆」Bot 發出的那條「📸 【員工完工回報】」通知，再輸入 `/ok`。");
    }

    // 🎯 核心黑科技：直接從被回覆的 Bot 通知文字中解構出任務名稱！
    const taskMatch = replyToMessage.text.match(/📝 待審核任務：(.*)\n/);
    if (!taskMatch) {
      return ctx.reply("❌ 無法識別該任務，請確保您回覆的是帶有「待審核任務：xxx」字樣的 Bot 通知。");
    }
    const taskTitle = taskMatch[1].trim();

    // 不管目前狀態是 active 還是 completed，只要名字對了且不是 closed，就直接強力結案！
    const { data: task, error } = await supabase
      .from("tasks")
      .update({ status: "closed" })
      .eq("title", taskTitle)
      .neq("status", "closed")
      .select()
      .limit(1)
      .maybeSingle();

    if (error || !task) {
      // 如果極端情況下 update 沒回傳，我們做最後一次強力嘗試
      const { data: retryTask } = await supabase
        .from("tasks")
        .select("*")
        .eq("title", taskTitle)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
        
      if (retryTask) {
        await supabase.from("tasks").update({ status: "closed" }).eq("id", retryTask.id);
        return ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${taskTitle}*」已強制結案！`);
      }
      return ctx.reply(`❌ 結案失敗，在資料庫中找不到名為「${taskTitle}」的任務。`);
    }

    // 在群組內公開宣告結案成功！
    await ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${task.title}*」已由主管審核通過，順利結案！大家辛苦了！`, {
      parse_mode: "Markdown"
    });
  } catch (err: any) {
    await ctx.reply(`💥 結案發生錯誤：${err.message}`);
  }
});

// 5. 將 grammY 轉換成 Next.js App Router 的 POST 處理器
export const POST = webhookCallback(bot, "std/http");