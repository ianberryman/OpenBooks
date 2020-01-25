package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.Account;
import org.openbooks.openbooksapi.core.model.ChartOfAccounts;
import org.openbooks.openbooksapi.core.model.Transaction;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import javax.persistence.EntityExistsException;
import java.util.List;
import java.util.Optional;

@RestController
public class AccountController {

    @Autowired
    private ChartOfAccounts coa;

    @GetMapping("/accounts")
    public List<Account> getAccounts(@RequestParam Optional<String> accountNumber) {
        return accountNumber.isPresent()
                ? coa.getAccountsByAccountNumber(accountNumber.get())
                : coa.getAccounts();
    }

    @GetMapping("/accounts/{id}")
    public Account getAccountById(@PathVariable Long id) {
        return coa.getAccountById(id).get();
    }

    @GetMapping("/accounts/{id}/transactions")
    public List<Transaction> getTransactionsForAccount(@PathVariable Long id) {
        return coa.getTransactionsForAccount(id);
    }

    @PostMapping("/accounts")
    public ResponseEntity<Account> createAccount(@RequestBody Account account) {
        System.out.println(account.getId());
        // throw error if account exists
        if (!account.idIsNull() && coa.getAccountById(account.getId()).isPresent()) {
            throw new EntityExistsException("Account with ID " + account.getId() + " already exists");
        }

        Account newAccount = coa.createAccount(account);

        return ResponseEntity.created(null).body(newAccount);
    }

    @PutMapping("/accounts")
    public ResponseEntity<Account> updateAccount(@RequestBody Account account) {
        // check if id exists, will throw error if account doesn't exist
        getAccountById(account.getId());

        // update Account and return new object data
        return ResponseEntity.ok().body(coa.updateAccount(account));
    }


    @DeleteMapping("/accounts/{id}")
    public ResponseEntity<ActionResponse> deleteAccount(@PathVariable Long id) {
        coa.deleteAccount(id);

        return ResponseEntity.ok(new ActionResponse("Account deleted"));
    }
}

