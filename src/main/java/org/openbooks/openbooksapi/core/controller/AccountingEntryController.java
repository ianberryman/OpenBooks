package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.AccountingEntry;
import org.openbooks.openbooksapi.core.model.Journal;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class AccountingEntryController {

    @Autowired
    private Journal journal;

    @GetMapping("/entries")
    public List<AccountingEntry> getEntries() {
        return journal.getAccountingEntries();
    }
}
