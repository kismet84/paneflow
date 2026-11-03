package com.codexpane.companion;

/** Goal lifecycle only. Turn idle and queue completed are not task completion evidence. */
final class NativeTaskCompletion {
    static boolean known(String state) {
        return "active".equals(state)||"paused".equals(state)||"blocked".equals(state)
            ||"usageLimited".equals(state)||"budgetLimited".equals(state)||"complete".equals(state);
    }
    static boolean completed(String previous,String current) {
        return known(previous)&&!"complete".equals(previous)&&"complete".equals(current);
    }
}
