package org.openbooks.openbooksapi.core.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

import javax.persistence.*;
import java.util.List;

@Entity
public class Company {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @JsonProperty("name")
    private String companyName;

    private String taxId;

    private String taxIdType;

    @ManyToOne(optional = false)
    @JoinColumn(name = "ADDRESS_ID")
    private Address address;

    private String website;

/*    @OneToMany(mappedBy = "company")
    @JsonIgnore
    private List<Account> accountList;

    @ManyToMany
    @JoinTable(
            name = "COMPANY_CUSTOMER",
            joinColumns = @JoinColumn(name = "COMPANY_ID"),
            inverseJoinColumns = @JoinColumn(name = "CUSTOMER_ID")
    )
    private List<Customer> customerList;*/

    public void addAccount(Account account) {
        //accountList.add(account);

        account.setCompany(this);
    }

    public void removeAccount(Account account) {
        //accountList.remove(account);

        account.setCompany(null);
    }

/*    public void addCustomer(Customer customer) {
        customerList.add(customer);
    }

    public void removeCustomer(Customer customer) {
        customerList.remove(customer);
    }*/

    public boolean idIsNull() {
        return id == null;
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getCompanyName() {
        return companyName;
    }

    public void setCompanyName(String companyName) {
        this.companyName = companyName;
    }

    public String getTaxId() {
        return taxId;
    }

    public void setTaxId(String taxId) {
        this.taxId = taxId;
    }

    public String getTaxIdType() {
        return taxIdType;
    }

    public void setTaxIdType(String taxIdType) {
        this.taxIdType = taxIdType;
    }

    public Address getAddress() {
        return address;
    }

    public void setAddress(Address address) {
        this.address = address;
    }

    public String getWebsite() {
        return website;
    }

    public void setWebsite(String website) {
        this.website = website;
    }

/*    public List<Account> getAccountList() {
        return accountList;
    }

    public void setAccountList(List<Account> accountList) {
        this.accountList = accountList;
    }

    public List<Customer> getCustomerList() {
        return customerList;
    }

    public void setCustomerList(List<Customer> customerList) {
        this.customerList = customerList;
    }*/
}
