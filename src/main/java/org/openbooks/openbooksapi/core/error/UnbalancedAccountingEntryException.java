package org.openbooks.openbooksapi.core.error;

public class UnbalancedAccountingEntryException extends Exception {

    private final String message;

    public UnbalancedAccountingEntryException(String message) {
        this.message = message;
    }

    public String getMessage() {
        return message;
    }
}
