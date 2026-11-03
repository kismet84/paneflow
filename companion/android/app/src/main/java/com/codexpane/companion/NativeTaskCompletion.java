package com.codexpane.companion;

/** Explicit goals take precedence; ordinary tasks require a verified final-answer marker. */
final class NativeTaskCompletion {
    static boolean ordinary(boolean goalKnown,String goal,String previous,String id,long completedAt,long watchingSince) {
        return goalKnown&&(goal==null||goal.isEmpty()||"null".equals(goal))
            &&id!=null&&!id.isEmpty()&&!id.equals(previous)&&watchingSince>0&&completedAt>=watchingSince;
    }
    static boolean known(String state) {
        return "active".equals(state)||"paused".equals(state)||"blocked".equals(state)
            ||"usageLimited".equals(state)||"budgetLimited".equals(state)||"complete".equals(state);
    }
    static boolean completed(String previous,String current) {
        return known(previous)&&!"complete".equals(previous)&&"complete".equals(current);
    }
}
